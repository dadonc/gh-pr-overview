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

interface NativeCounterState {
  element: HTMLAnchorElement;
  snapshot: AttributeSnapshot;
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

function totalComments(extraction: PullRequestRowExtraction): SectionState<TotalComments> {
  const native = extraction.nativeComments;
  if (native.status === 'ready') return { data: { count: native.count, href: native.href }, status: 'ready' };
  if (native.status === 'zero') return { data: { count: 0, href: `/${extraction.identity.owner}/${extraction.identity.repository}/pull/${extraction.identity.number}` }, status: 'ready' };
  return { message: native.reason, status: 'error' };
}

function sameNativeComments(left: PullRequestRowExtraction['nativeComments'], right: PullRequestRowExtraction['nativeComments']): boolean {
  if (left.status !== right.status) return false;
  if (left.status === 'ready' && right.status === 'ready') return left.count === right.count && left.href === right.href;
  return left.status !== 'error' || right.status !== 'error' || left.reason === right.reason;
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
  private currentExtraction: PullRequestRowExtraction;
  private readonly mountAnchor: HTMLSpanElement;
  private mounted?: MountedCard;
  private nativeCounter?: NativeCounterState;
  private pendingProps: CardProps;
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
    this.mountAnchor = this.createMountAnchor();
    this.adoptNativeCounter(extraction);
    this.pendingProps = this.props(loadingSummary(extraction));
    let mounting: MountedCard | Promise<MountedCard>;
    try {
      mounting = uiFactory.mount(this.mountAnchor, this.pendingProps);
    } catch {
      this.dispose();
      return;
    }
    Promise.resolve(mounting).then((mounted) => {
      if (this.disposed || !this.ownsConnectedMountAnchor()) { mounted.remove(); return; }
      this.mounted = mounted;
      this.hideCurrentNativeCounter();
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

  private createMountAnchor(): HTMLSpanElement {
    const anchor = this.document.createElement('span');
    anchor.setAttribute('data-pr-overview-mount-anchor', '');
    anchor.setAttribute('aria-hidden', 'true');
    const title = findPullRequestTitle(this.row)?.anchor;
    const openedBy = this.row.querySelector('.opened-by');
    const metadata = openedBy?.parentElement;
    const mainContent = title?.closest<HTMLElement>('.flex-auto.min-width-0, .flex-auto, .min-width-0');
    if (title && metadata && metadata !== this.row && mainContent?.contains(metadata) && this.safeMountContainer(metadata, title)) {
      metadata.after(anchor);
    } else if (openedBy && this.safeMountContainer(openedBy.parentElement, title)) {
      openedBy.after(anchor);
    } else {
      const rowEnd = this.row.querySelector('.comment-area, [data-testid="issue-row-end"], .js-issue-meta, .js-issue-row-meta');
      if (this.safeMountContainer(rowEnd, title)) rowEnd!.append(anchor);
      else if (this.safeMountContainer(title?.parentElement, title)) title!.parentElement!.append(anchor);
      else if (this.safeMountContainer(mainContent, title)) mainContent!.append(anchor);
      else this.row.append(anchor);
    }
    return anchor;
  }

  private safeMountContainer(container: Element | null | undefined, title: HTMLAnchorElement | undefined): container is HTMLElement {
    if (!container || !(container instanceof HTMLElement)) return false;
    return this.row.contains(container) &&
      !container.matches('a, .opened-by, .hide-sm') &&
      !container.closest('a, .opened-by, .hide-sm') &&
      !(title && (container === title || title.contains(container)));
  }

  private ownsConnectedMountAnchor(): boolean {
    return this.mountAnchor.isConnected &&
      this.mountAnchor.closest<HTMLElement>('[id^="issue_"].js-issue-row') === this.row;
  }

  private snapshot(element: Element): AttributeSnapshot {
    return { ariaHidden: element.getAttribute('aria-hidden'), hidden: element.getAttribute('hidden'), style: element.getAttribute('style'), tabindex: element.getAttribute('tabindex') };
  }

  private hideCurrentNativeCounter(): void {
    const state = this.nativeCounter;
    if (!state || nativeCounter(this.row, this.currentExtraction) !== state.element) return;
    state.element.hidden = true;
    state.element.setAttribute('aria-hidden', 'true');
    state.element.setAttribute('tabindex', '-1');
  }

  private restoreNativeCounter(): void {
    const state = this.nativeCounter;
    if (!state) return;
    setAttributeExactly(state.element, 'hidden', state.snapshot.hidden);
    setAttributeExactly(state.element, 'aria-hidden', state.snapshot.ariaHidden);
    setAttributeExactly(state.element, 'tabindex', state.snapshot.tabindex);
    setAttributeExactly(state.element, 'style', state.snapshot.style);
    this.nativeCounter = undefined;
  }

  private adoptNativeCounter(extraction: PullRequestRowExtraction): void {
    const element = nativeCounter(this.row, extraction);
    if (element === this.nativeCounter?.element) return;
    this.restoreNativeCounter();
    if (!element) return;
    this.nativeCounter = { element, snapshot: this.snapshot(element) };
    if (this.mounted) this.hideCurrentNativeCounter();
  }

  private needsNativeCounterRefresh(extraction: PullRequestRowExtraction): boolean {
    if (!this.nativeCounter) return extraction.nativeComments.status !== 'zero';
    return !this.nativeCounter.element.isConnected ||
      !this.row.contains(this.nativeCounter.element) ||
      !sameNativeComments(this.currentExtraction.nativeComments, extraction.nativeComments);
  }

  private setAuthoredAttribute(): void {
    if (loadingSummary(this.currentExtraction).authoredByViewer) this.row.setAttribute('data-pr-overview-authored', 'true');
  }

  private props(summary: PullRequestSummary): CardProps {
    const base = `/${this.currentExtraction.identity.owner}/${this.currentExtraction.identity.repository}/pull/${this.currentExtraction.identity.number}`;
    return { conversationHref: base, filesHref: `${base}/files`, summary };
  }

  private refreshNative(extraction: PullRequestRowExtraction, nativeDirty: boolean): void {
    if (this.disposed) return;
    if (identityKey(extraction.identity) !== identityKey(this.currentExtraction.identity)) return;
    const refreshNativeCounter = nativeDirty || this.needsNativeCounterRefresh(extraction);
    this.currentExtraction = extraction;
    if (refreshNativeCounter) this.adoptNativeCounter(extraction);
    this.render(this.props({ ...this.pendingProps.summary, totalComments: totalComments(extraction) }));
  }

  private render(props: CardProps): void {
    this.pendingProps = props;
    this.mounted?.update(props);
  }

  matches(extraction: PullRequestRowExtraction): boolean {
    return !this.disposed &&
      identityKey(extraction.identity) === identityKey(this.currentExtraction.identity) &&
      this.ownsConnectedMountAnchor();
  }

  refresh(extraction: PullRequestRowExtraction, nativeDirty: boolean): void {
    this.refreshNative(extraction, nativeDirty);
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
      this.adoptNativeCounter(extraction);
      this.render(this.props(summaryWithRemote(extraction, remote)));
    }).catch((error: unknown) => {
      if (this.disposed || this.ownEpoch !== this.epoch() || abortController.signal.aborted) return;
      const extraction = matchingExtraction();
      if (!extraction) return;
      this.currentExtraction = extraction;
      this.adoptNativeCounter(extraction);
      const message = error instanceof Error ? error.message : 'GitHub data could not be loaded.';
      this.render(this.props({ ...loadingSummary(extraction), agents: { message, status: 'error' }, diff: { message, status: 'error' }, reviewThreads: { message, status: 'error' } }));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.intersectionObserver?.disconnect();
    this.mounted?.remove();
    this.restoreNativeCounter();
    this.mountAnchor.remove();
    setAttributeExactly(this.row, 'data-pr-overview-authored', this.authoredAttribute);
  }
}

export function isPullRequestListRoute(url: Pick<Location, 'pathname'>): boolean {
  return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(url.pathname);
}

export function createPageReconciler(options: PageReconcilerOptions) {
  const controllers = new Map<HTMLElement, RowController>();
  const nativeDirtyRows = new Set<HTMLElement>();
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
          node.nodeType === 1 && Boolean((node as Element).matches('github-pr-overview, [data-pr-overview-mount-anchor]') || (node as Element).closest('github-pr-overview')),
        );
      })) return;
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
        const row = target?.closest<HTMLElement>('[id^="issue_"].js-issue-row');
        if (row) nativeDirtyRows.add(row);
      }
      queueReconcile();
    });
    observer.observe(options.document, {
      attributeFilter: ['aria-label', 'class', 'content', 'data-comment-count', 'data-hovercard-type', 'data-login', 'href', 'role'],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  };
  const clear = () => {
    currentEpoch += 1;
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
    nativeDirtyRows.clear();
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
      const nativeDirty = nativeDirtyRows.delete(row);
      if (!found.has(row) || !extraction || !controller.matches(extraction)) {
        controller.dispose();
        controllers.delete(row);
      } else {
        controller.refresh(extraction, nativeDirty);
      }
    }
    for (const row of rows) {
      if (controllers.has(row)) continue;
      const extraction = extractions.get(row);
      if (!extraction) continue;
      controllers.set(row, new RowController(options.document, row, extraction, options.client, options.uiFactory, () => currentEpoch, currentEpoch, options.IntersectionObserver));
    }
    nativeDirtyRows.clear();
  };
  return {
    cleanup() { stopped = true; observer?.disconnect(); observer = undefined; clear(); },
    reconcile,
  };
}
