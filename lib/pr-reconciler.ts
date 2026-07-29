import type { PullRequestSummary, SectionState, TotalComments } from './domain';
import type { PullRequestRemoteSummary } from './github-client';
import type { PullRequestRowExtraction } from './github-dom';
import { extractPullRequestRows } from './github-dom';

export interface PullRequestClient {
  loadPullRequest(identity: PullRequestRowExtraction['identity'], signal?: AbortSignal): Promise<PullRequestRemoteSummary>;
}

export interface CardProps {
  conversationHref: string;
  filesHref: string;
  summary: PullRequestSummary;
}

export interface MountedCard {
  remove(): void;
  update(props: CardProps): void;
}

export interface CardUiFactory {
  mount(anchor: Element, props: CardProps): MountedCard | Promise<MountedCard>;
}

export interface ObserverConstructor {
  new (callback: IntersectionObserverCallback, options?: IntersectionObserverInit): IntersectionObserver;
}

export interface PageReconcilerOptions {
  document: Document;
  client: PullRequestClient;
  uiFactory: CardUiFactory;
  IntersectionObserver?: ObserverConstructor;
}

interface AttributeSnapshot {
  ariaHidden: string | null;
  hidden: string | null;
  tabindex: string | null;
  style: string | null;
}

function identityKey(identity: PullRequestRowExtraction['identity']): string {
  return `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`;
}

function canonicalIdentity(row: Element): string | undefined {
  for (const anchor of row.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const match = new URL(anchor.href, 'https://github.com').pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
    if (match) return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}`;
  }
  return undefined;
}

function extractionForRow(document: Document, row: HTMLElement): PullRequestRowExtraction | undefined {
  const key = canonicalIdentity(row);
  return key ? extractPullRequestRows(document).find((candidate) => identityKey(candidate.identity) === key) : undefined;
}

function nativeCounter(row: HTMLElement): HTMLAnchorElement | undefined {
  return [...row.querySelectorAll<HTMLAnchorElement>('a[href]')].find((anchor) => {
    if (anchor.closest('github-pr-overview')) return false;
    const label = anchor.getAttribute('aria-label') ?? '';
    return /comments?/i.test(label) || /comments?/i.test(anchor.className) || /^\s*[\d,]+\s+comments?\s*$/i.test(anchor.textContent ?? '');
  });
}

function totalComments(extraction: PullRequestRowExtraction): SectionState<TotalComments> {
  const native = extraction.nativeComments;
  if (native.status === 'ready') return { data: { count: native.count, href: native.href }, status: 'ready' };
  if (native.status === 'zero') return { data: { count: 0, href: `/${extraction.identity.owner}/${extraction.identity.repository}/pull/${extraction.identity.number}` }, status: 'ready' };
  return { message: native.reason, status: 'error' };
}

function loadingSummary(extraction: PullRequestRowExtraction): PullRequestSummary {
  return {
    agents: { status: 'loading' },
    authoredByViewer: Boolean(extraction.viewerLogin && extraction.authorLogin && extraction.viewerLogin.toLowerCase() === extraction.authorLogin.toLowerCase()),
    diff: { status: 'loading' },
    reviewThreads: { status: 'loading' },
    totalComments: totalComments(extraction),
  };
}

function summaryWithRemote(extraction: PullRequestRowExtraction, remote: PullRequestRemoteSummary): PullRequestSummary {
  return { ...loadingSummary(extraction), ...remote, totalComments: totalComments(extraction) };
}

function setAttributeExactly(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

class RowController {
  private abortController?: AbortController;
  private anchor: HTMLAnchorElement;
  private anchorSnapshot: AttributeSnapshot;
  private currentExtraction: PullRequestRowExtraction;
  private extensionAnchor?: HTMLAnchorElement;
  private mounted?: MountedCard;
  private pendingProps: CardProps;
  private nativeObserver: MutationObserver;
  private intersectionObserver?: IntersectionObserver;
  private readonly authoredAttribute: string | null;
  private started = false;
  private disposed = false;

  constructor(
    private readonly document: Document,
    private readonly row: HTMLElement,
    extraction: PullRequestRowExtraction,
    private readonly client: PullRequestClient,
    private readonly uiFactory: CardUiFactory,
    private readonly epoch: () => number,
    private readonly ownEpoch: number,
    IntersectionObserverCtor: ObserverConstructor | undefined,
  ) {
    this.currentExtraction = extraction;
    this.authoredAttribute = row.getAttribute('data-pr-overview-authored');
    const counter = nativeCounter(row);
    this.anchor = counter ?? this.createZeroAnchor();
    this.anchorSnapshot = this.snapshot(this.anchor);
    this.hideNative(this.anchor);
    this.setAuthoredAttribute();
    this.pendingProps = this.props(loadingSummary(extraction));
    Promise.resolve(uiFactory.mount(this.anchor, this.pendingProps)).then((mounted) => {
      if (this.disposed) { mounted.remove(); return; }
      this.mounted = mounted;
      mounted.update(this.pendingProps);
    });
    this.nativeObserver = new MutationObserver(() => this.refreshNative());
    this.nativeObserver.observe(this.anchor, { attributes: true, attributeFilter: ['aria-label', 'href'], childList: true, characterData: true, subtree: true });
    if (IntersectionObserverCtor) {
      const observer = new IntersectionObserverCtor((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          this.start();
        }
      }, { rootMargin: '800px' });
      this.intersectionObserver = observer;
      observer.observe(this.row);
    } else {
      this.start();
    }
  }

  private createZeroAnchor(): HTMLAnchorElement {
    const anchor = this.document.createElement('a');
    anchor.setAttribute('data-pr-overview-zero-anchor', '');
    anchor.href = `/${this.currentExtraction.identity.owner}/${this.currentExtraction.identity.repository}/pull/${this.currentExtraction.identity.number}`;
    const target = this.row.querySelector('.comment-area, .js-issue-meta, .opened-by') ?? this.row;
    target.append(anchor);
    this.extensionAnchor = anchor;
    return anchor;
  }

  private snapshot(anchor: HTMLAnchorElement): AttributeSnapshot {
    return { ariaHidden: anchor.getAttribute('aria-hidden'), hidden: anchor.getAttribute('hidden'), style: anchor.getAttribute('style'), tabindex: anchor.getAttribute('tabindex') };
  }

  private hideNative(anchor: HTMLAnchorElement): void {
    if (anchor !== this.extensionAnchor) {
      anchor.hidden = true;
      anchor.setAttribute('aria-hidden', 'true');
      anchor.setAttribute('tabindex', '-1');
    }
  }

  private restoreAnchor(): void {
    if (this.anchor === this.extensionAnchor) {
      this.extensionAnchor?.remove();
      return;
    }
    setAttributeExactly(this.anchor, 'hidden', this.anchorSnapshot.hidden);
    setAttributeExactly(this.anchor, 'aria-hidden', this.anchorSnapshot.ariaHidden);
    setAttributeExactly(this.anchor, 'tabindex', this.anchorSnapshot.tabindex);
    setAttributeExactly(this.anchor, 'style', this.anchorSnapshot.style);
  }

  private setAuthoredAttribute(): void {
    if (loadingSummary(this.currentExtraction).authoredByViewer) this.row.setAttribute('data-pr-overview-authored', 'true');
  }

  private props(summary: PullRequestSummary): CardProps {
    const base = `/${this.currentExtraction.identity.owner}/${this.currentExtraction.identity.repository}/pull/${this.currentExtraction.identity.number}`;
    return { conversationHref: base, filesHref: `${base}/files`, summary };
  }

  private refreshNative(): void {
    if (this.disposed) return;
    const extraction = extractionForRow(this.document, this.row);
    if (!extraction) return;
    this.currentExtraction = extraction;
    this.render(this.props({ ...this.pendingProps.summary, totalComments: totalComments(extraction) }));
  }

  private render(props: CardProps): void {
    this.pendingProps = props;
    this.mounted?.update(props);
  }

  matches(extraction: PullRequestRowExtraction): boolean {
    const nextAnchor = nativeCounter(this.row);
    return identityKey(extraction.identity) === identityKey(this.currentExtraction.identity) && (nextAnchor ?? this.extensionAnchor) === this.anchor;
  }

  refresh(): void {
    this.refreshNative();
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.abortController = new AbortController();
    this.client.loadPullRequest(this.currentExtraction.identity, this.abortController.signal).then((remote) => {
      if (this.disposed || this.ownEpoch !== this.epoch() || this.abortController?.signal.aborted) return;
      const extraction = extractionForRow(this.document, this.row) ?? this.currentExtraction;
      this.currentExtraction = extraction;
      this.render(this.props(summaryWithRemote(extraction, remote)));
    }).catch((error: unknown) => {
      if (this.disposed || this.abortController?.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'GitHub data could not be loaded.';
      this.render(this.props({ ...loadingSummary(this.currentExtraction), agents: { message, status: 'error' }, diff: { message, status: 'error' }, reviewThreads: { message, status: 'error' } }));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.intersectionObserver?.disconnect();
    this.nativeObserver.disconnect();
    this.mounted?.remove();
    this.restoreAnchor();
    setAttributeExactly(this.row, 'data-pr-overview-authored', this.authoredAttribute);
  }
}

export function isPullRequestListRoute(url: Pick<Location, 'pathname'>): boolean {
  return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(url.pathname);
}

export function createPageReconciler(options: PageReconcilerOptions) {
  const controllers = new Map<HTMLElement, RowController>();
  let currentEpoch = 0;
  let observer: MutationObserver | undefined;
  let queued = false;
  let stopped = false;
  const queueReconcile = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!stopped) reconcile(); });
  };
  const observe = () => {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (records.every((record) => record.target.nodeType === 1 && Boolean((record.target as Element).closest('github-pr-overview')))) return;
      queueReconcile();
    });
    observer.observe(options.document.documentElement, { childList: true, subtree: true });
  };
  const clear = () => {
    currentEpoch += 1;
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
  };
  const reconcile = () => {
    observe();
    if (!isPullRequestListRoute(options.document.location)) { clear(); return; }
    const rows = [...options.document.querySelectorAll<HTMLElement>('[id^="issue_"].js-issue-row')];
    const found = new Set(rows);
    for (const [row, controller] of controllers) {
      const extraction = row.isConnected ? extractionForRow(options.document, row) : undefined;
      if (!found.has(row) || !extraction || !controller.matches(extraction)) {
        controller.dispose();
        controllers.delete(row);
      } else {
        controller.refresh();
      }
    }
    for (const row of rows) {
      if (controllers.has(row)) continue;
      const extraction = extractionForRow(options.document, row);
      if (!extraction) continue;
      controllers.set(row, new RowController(options.document, row, extraction, options.client, options.uiFactory, () => currentEpoch, currentEpoch, options.IntersectionObserver));
    }
  };
  return {
    cleanup() { stopped = true; observer?.disconnect(); observer = undefined; clear(); },
    reconcile,
    reset() { stopped = false; clear(); reconcile(); },
  };
}
