import type { PullRequestSummary, SectionState, TotalComments } from './domain';
import type { PullRequestIdentity } from './domain';
import type { PullRequestRemoteSummary } from './github-client';
import type { PullRequestRowExtraction } from './github-dom';
import {
  extractPullRequestRow,
  findNativeCommentCounter,
  findPullRequestTitle,
} from './github-dom';

export interface PullRequestClient {
  loadPullRequest(identity: PullRequestIdentity, signal?: AbortSignal): Promise<PullRequestRemoteSummary>;
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

function identityKey(identity: PullRequestIdentity): string {
  return `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`;
}

/** Mirrors the extractor's counter semantics and never mistakes the PR title for a counter. */
function nativeCounter(row: HTMLElement, extraction: PullRequestRowExtraction): HTMLAnchorElement | undefined {
  if (extraction.nativeComments.status === 'zero') return undefined;
  const title = findPullRequestTitle(row)?.anchor;
  return findNativeCommentCounter(row, title);
}

function matchesReadyNativeCounter(anchor: HTMLElement, extraction: PullRequestRowExtraction): boolean {
  if (extraction.nativeComments.status !== 'ready' || !(anchor instanceof HTMLAnchorElement)) return false;
  const label = anchor.getAttribute('aria-label');
  const count = label?.match(/^\s*(\d{1,3}(?:,\d{3})+|\d+)\s+comments?\s*$/i)?.[1];
  return count !== undefined &&
    Number.isSafeInteger(Number(count.replaceAll(',', ''))) &&
    Number(count.replaceAll(',', '')) === extraction.nativeComments.count &&
    anchor.getAttribute('href') === extraction.nativeComments.href;
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
  private anchor: HTMLElement;
  private anchorSnapshot: AttributeSnapshot;
  private currentExtraction: PullRequestRowExtraction;
  private extensionAnchor?: HTMLSpanElement;
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
    const counter = nativeCounter(row, extraction);
    this.anchor = counter ?? this.createZeroAnchor();
    this.anchorSnapshot = this.snapshot(this.anchor);
    this.pendingProps = this.props(loadingSummary(extraction));
    this.nativeObserver = new MutationObserver(() => this.refresh(this.currentExtraction));
    this.nativeObserver.observe(this.anchor, { attributes: true, attributeFilter: ['aria-label', 'href'], childList: true, characterData: true, subtree: true });
    let mounting: MountedCard | Promise<MountedCard>;
    try {
      mounting = uiFactory.mount(this.anchor, this.pendingProps);
    } catch {
      this.dispose();
      return;
    }
    Promise.resolve(mounting).then((mounted) => {
      if (this.disposed) { mounted.remove(); return; }
      this.mounted = mounted;
      this.hideNative(this.anchor);
      this.setAuthoredAttribute();
      mounted.update(this.pendingProps);
    }).catch(() => this.dispose());
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

  private createZeroAnchor(): HTMLSpanElement {
    const anchor = this.document.createElement('span');
    anchor.setAttribute('data-pr-overview-zero-anchor', '');
    const target = this.row.querySelector('.comment-area, [data-testid="issue-row-end"], .js-issue-meta, .js-issue-row-meta, .opened-by') ?? this.row;
    target.append(anchor);
    this.extensionAnchor = anchor;
    return anchor;
  }

  private snapshot(anchor: HTMLElement): AttributeSnapshot {
    return { ariaHidden: anchor.getAttribute('aria-hidden'), hidden: anchor.getAttribute('hidden'), style: anchor.getAttribute('style'), tabindex: anchor.getAttribute('tabindex') };
  }

  private hideNative(anchor: HTMLElement): void {
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

  private refreshNative(extraction: PullRequestRowExtraction): void {
    if (this.disposed) return;
    if (identityKey(extraction.identity) !== identityKey(this.currentExtraction.identity)) return;
    this.currentExtraction = extraction;
    this.render(this.props({ ...this.pendingProps.summary, totalComments: totalComments(extraction) }));
  }

  private render(props: CardProps): void {
    this.pendingProps = props;
    this.mounted?.update(props);
  }

  matches(extraction: PullRequestRowExtraction): boolean {
    if (this.disposed) return false;
    if (identityKey(extraction.identity) !== identityKey(this.currentExtraction.identity)) return false;
    if (
      extraction.nativeComments.status === 'zero' &&
      this.anchor === this.extensionAnchor &&
      this.row.contains(this.anchor)
    ) return true;
    if (this.row.contains(this.anchor) && matchesReadyNativeCounter(this.anchor, extraction)) return true;
    const nextAnchor = nativeCounter(this.row, extraction);
    return (nextAnchor ?? this.extensionAnchor) === this.anchor;
  }

  refresh(extraction: PullRequestRowExtraction): void {
    this.refreshNative(extraction);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const requestedIdentity = this.currentExtraction.identity;
    const requestedKey = identityKey(requestedIdentity);
    const abortController = new AbortController();
    this.abortController = abortController;
    const matchingExtraction = () => {
      const extraction = extractPullRequestRow(this.row, this.currentExtraction.viewerLogin);
      return extraction && identityKey(extraction.identity) === requestedKey && this.matches(extraction)
        ? extraction
        : undefined;
    };
    this.client.loadPullRequest(requestedIdentity, abortController.signal).then((remote) => {
      if (this.disposed || this.ownEpoch !== this.epoch() || abortController.signal.aborted) return;
      const extraction = matchingExtraction();
      if (!extraction) return;
      this.currentExtraction = extraction;
      this.render(this.props(summaryWithRemote(extraction, remote)));
    }).catch((error: unknown) => {
      if (this.disposed || this.ownEpoch !== this.epoch() || abortController.signal.aborted) return;
      const extraction = matchingExtraction();
      if (!extraction) return;
      this.currentExtraction = extraction;
      const message = error instanceof Error ? error.message : 'GitHub data could not be loaded.';
      this.render(this.props({ ...loadingSummary(extraction), agents: { message, status: 'error' }, diff: { message, status: 'error' }, reviewThreads: { message, status: 'error' } }));
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
      if (records.every((record) => {
        if (record.target.nodeType === 1 && (record.target as Element).closest('github-pr-overview')) return true;
        if (record.type !== 'childList') return false;
        const changedNodes = [...record.addedNodes, ...record.removedNodes];
        return changedNodes.length > 0 && changedNodes.every((node) =>
          node.nodeType === 1 && Boolean((node as Element).matches('github-pr-overview, [data-pr-overview-zero-anchor]') || (node as Element).closest('github-pr-overview')),
        );
      })) return;
      queueReconcile();
    });
    observer.observe(options.document, {
      attributeFilter: ['aria-label', 'content', 'data-hovercard-type', 'data-login', 'href'],
      attributes: true,
      childList: true,
      subtree: true,
    });
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
    const viewerLogin =
      options.document.querySelector('meta[name="user-login"]')
        ?.getAttribute('content')
        ?.trim() || undefined;
    const extractions = new Map(rows.flatMap((row) => {
      const extraction = extractPullRequestRow(row, viewerLogin);
      return extraction ? [[row, extraction] as const] : [];
    }));
    const found = new Set(rows);
    for (const [row, controller] of controllers) {
      const extraction = row.isConnected ? extractions.get(row) : undefined;
      if (!found.has(row) || !extraction || !controller.matches(extraction)) {
        controller.dispose();
        controllers.delete(row);
      } else {
        controller.refresh(extraction);
      }
    }
    for (const row of rows) {
      if (controllers.has(row)) continue;
      const extraction = extractions.get(row);
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
