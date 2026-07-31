import type { PullRequestSummary, SectionState } from './domain';
import type { PullRequestIdentity } from './domain';
import type {
  PullRequestLoadOptions,
  PullRequestRemoteSummary,
  PullRequestRemoteUpdate,
} from './github-client';
import type { PullRequestRowExtraction } from './github-dom';
import {
  extractPullRequestRow,
  findPullRequestTitle,
} from './github-dom';
import { createPrLoadScheduler } from './pr-load-scheduler';

export interface PullRequestClient {
  loadPullRequest(identity: PullRequestIdentity, options?: PullRequestLoadOptions): Promise<PullRequestRemoteSummary>;
}

export interface CardProps {
  conversationHref: string;
  filesHref: string;
  summary: PullRequestSummary;
}

export interface MountedCard {
  isConnected(): boolean;
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

function identityKey(identity: PullRequestIdentity): string {
  return `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`;
}

function loadingSummary(extraction: PullRequestRowExtraction): PullRequestSummary {
  return {
    agents: { status: 'loading' },
    authoredByViewer: Boolean(extraction.viewerLogin && extraction.authorLogin && extraction.viewerLogin.toLowerCase() === extraction.authorLogin.toLowerCase()),
    diff: { status: 'loading' },
    reviewThreads: { status: 'loading' },
  };
}

function mergeSection<T>(
  current: SectionState<T>,
  next: SectionState<T> | undefined,
): SectionState<T> {
  if (!next || (next.status === 'loading' && current.status !== 'loading')) return current;
  return next;
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
  private pendingProps: CardProps;
  private readonly authoredAttribute: string | null;
  private started = false;
  private disposed = false;
  private pendingMountedUiRemoval = false;

  constructor(
    private readonly document: Document,
    private readonly row: HTMLElement,
    extraction: PullRequestRowExtraction,
    private readonly client: PullRequestClient,
    private readonly uiFactory: CardUiFactory,
    private readonly epoch: () => number,
    private readonly ownEpoch: number,
    private readonly ignoreOwnedRemoval: (node: Node) => void,
    private readonly requestReconcile: () => void,
  ) {
    this.currentExtraction = extraction;
    this.authoredAttribute = row.getAttribute('data-pr-overview-authored');
    this.mountAnchor = this.createMountAnchor();
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
      if (!mounted.isConnected()) {
        const shouldRetry = this.pendingMountedUiRemoval;
        mounted.remove();
        this.dispose();
        if (shouldRetry) this.requestReconcile();
        return;
      }
      this.mounted = mounted;
      this.setAuthoredAttribute();
      mounted.update(this.pendingProps);
    }).catch(() => this.dispose());
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

  private ownsConnectedMountedUi(): boolean {
    return !this.mounted || this.mounted.isConnected();
  }

  private setAuthoredAttribute(): void {
    if (loadingSummary(this.currentExtraction).authoredByViewer) this.row.setAttribute('data-pr-overview-authored', 'true');
  }

  private props(summary: PullRequestSummary): CardProps {
    const base = `/${this.currentExtraction.identity.owner}/${this.currentExtraction.identity.repository}/pull/${this.currentExtraction.identity.number}`;
    return { conversationHref: base, filesHref: `${base}/files`, summary };
  }

  private refreshExtraction(extraction: PullRequestRowExtraction): void {
    if (this.disposed) return;
    if (identityKey(extraction.identity) !== identityKey(this.currentExtraction.identity)) return;
    this.currentExtraction = extraction;
  }

  private render(props: CardProps): void {
    this.pendingProps = props;
    this.mounted?.update(props);
  }

  matches(extraction: PullRequestRowExtraction): boolean {
    return !this.disposed &&
      identityKey(extraction.identity) === identityKey(this.currentExtraction.identity) &&
      this.ownsConnectedMountAnchor() &&
      this.ownsConnectedMountedUi();
  }

  refresh(extraction: PullRequestRowExtraction): void {
    this.refreshExtraction(extraction);
  }

  noteMountedUiRemoval(): void {
    if (!this.mounted) this.pendingMountedUiRemoval = true;
  }

  async start(): Promise<void> {
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
    const mergeRemote = (remote: Partial<PullRequestRemoteSummary>) => {
      if (this.disposed || this.ownEpoch !== this.epoch() || abortController.signal.aborted) return;
      const extraction = matchingExtraction();
      if (!extraction) return;
      this.currentExtraction = extraction;
      const current = this.pendingProps.summary;
      this.render(this.props({
        ...current,
        agents: mergeSection(current.agents, remote.agents),
        authoredByViewer: loadingSummary(extraction).authoredByViewer,
        diff: mergeSection(current.diff, remote.diff),
        reviewThreads: mergeSection(current.reviewThreads, remote.reviewThreads),
      }));
    };
    const mergeUpdate = (update: PullRequestRemoteUpdate) => {
      if (update.kind === 'diff') mergeRemote({ diff: update.diff });
      else if (update.kind === 'timeline') {
        mergeRemote({ agents: update.agents, reviewThreads: update.reviewThreads });
      } else {
        mergeRemote(update.summary);
      }
    };
    try {
      const remote = await this.client.loadPullRequest(requestedIdentity, {
        onUpdate: mergeUpdate,
        signal: abortController.signal,
      });
      mergeRemote(remote);
    } catch (error: unknown) {
      if (this.disposed || this.ownEpoch !== this.epoch() || abortController.signal.aborted) return;
      const extraction = matchingExtraction();
      if (!extraction) return;
      this.currentExtraction = extraction;
      const message = error instanceof Error ? error.message : 'GitHub data could not be loaded.';
      const current = this.pendingProps.summary;
      const errorSection = <T>(section: SectionState<T>): SectionState<T> =>
        section.status === 'loading' ? { message, status: 'error' } : section;
      this.render(this.props({
        ...current,
        agents: errorSection(current.agents),
        authoredByViewer: loadingSummary(extraction).authoredByViewer,
        diff: errorSection(current.diff),
        reviewThreads: errorSection(current.reviewThreads),
      }));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.mounted?.remove();
    if (this.mountAnchor.isConnected) this.ignoreOwnedRemoval(this.mountAnchor);
    this.mountAnchor.remove();
    setAttributeExactly(this.row, 'data-pr-overview-authored', this.authoredAttribute);
  }
}

export function isPullRequestListRoute(url: Pick<Location, 'pathname'>): boolean {
  return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(url.pathname);
}

export function createPageReconciler(options: PageReconcilerOptions) {
  const controllers = new Map<HTMLElement, RowController>();
  const scheduler = createPrLoadScheduler<RowController>(2);
  const mountedUiDirtyRows = new Set<HTMLElement>();
  const ignoredOwnedRemovals = new WeakSet<Node>();
  let currentEpoch = 0;
  let observer: MutationObserver | undefined;
  let queued = false;
  let stopped = false;
  const orderedControllers = () =>
    [...options.document.querySelectorAll<HTMLElement>('[id^="issue_"].js-issue-row')]
      .flatMap((row) => {
        const controller = controllers.get(row);
        return controller ? [controller] : [];
      });
  const intersectionObserver = options.IntersectionObserver
    ? new options.IntersectionObserver((entries) => {
        scheduler.setOrder(orderedControllers());
        scheduler.updateEligibility(entries.flatMap((entry) => {
          const controller = controllers.get(entry.target as HTMLElement);
          return controller ? [{ eligible: entry.isIntersecting, job: controller }] : [];
        }));
      }, { rootMargin: '800px' })
    : undefined;
  const queueReconcile = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!stopped) reconcile(); });
  };
  const observe = () => {
    if (observer) return;
    observer = new MutationObserver((records) => {
      const relevantRecords = records.filter((record) => {
        if (record.target.nodeType === 1 && (record.target as Element).closest('github-pr-overview')) return false;
        if (record.type !== 'childList') return true;
        const addedNodes = [...record.addedNodes];
        const removedNodes = [...record.removedNodes];
        if (removedNodes.length > 0) return !removedNodes.every((node) => ignoredOwnedRemovals.delete(node));
        return !(addedNodes.length > 0 && addedNodes.every((node) =>
          node.nodeType === 1 && Boolean((node as Element).matches('github-pr-overview, [data-pr-overview-mount-anchor]') || (node as Element).closest('github-pr-overview')),
        ));
      });
      if (relevantRecords.length === 0) return;
      for (const record of relevantRecords) {
        const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
        const row = target?.closest<HTMLElement>('[id^="issue_"].js-issue-row');
        if (!row) continue;
        if (record.type === 'childList' && [...record.removedNodes].some((node) =>
          node.nodeType === 1 &&
          ((node as Element).matches('github-pr-overview') || Boolean((node as Element).querySelector('github-pr-overview'))),
        )) mountedUiDirtyRows.add(row);
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
    scheduler.clear();
    for (const [row, controller] of controllers) {
      intersectionObserver?.unobserve(row);
      controller.dispose();
    }
    controllers.clear();
    mountedUiDirtyRows.clear();
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
    const staleControllers: Array<readonly [HTMLElement, RowController]> = [];
    for (const [row, controller] of controllers) {
      const extraction = row.isConnected ? extractions.get(row) : undefined;
      const mountedUiDirty = mountedUiDirtyRows.delete(row);
      if (!found.has(row) || !extraction || !controller.matches(extraction)) {
        staleControllers.push([row, controller]);
      } else {
        if (mountedUiDirty) controller.noteMountedUiRemoval();
        controller.refresh(extraction);
      }
    }
    for (const [row, controller] of staleControllers) {
      intersectionObserver?.unobserve(row);
      controller.dispose();
      controllers.delete(row);
    }
    for (const [, controller] of staleControllers) scheduler.unregister(controller);
    for (const row of rows) {
      if (controllers.has(row)) continue;
      const extraction = extractions.get(row);
      if (!extraction) continue;
      const controller = new RowController(
        options.document,
        row,
        extraction,
        options.client,
        options.uiFactory,
        () => currentEpoch,
        currentEpoch,
        (node) => ignoredOwnedRemovals.add(node),
        queueReconcile,
      );
      controllers.set(row, controller);
      scheduler.register(controller, () => controller.start());
      intersectionObserver?.observe(row);
    }
    const order = orderedControllers();
    scheduler.setOrder(order);
    if (!intersectionObserver) {
      scheduler.updateEligibility(order.map((job) => ({ eligible: true, job })));
    }
    mountedUiDirtyRows.clear();
  };
  return {
    cleanup() {
      stopped = true;
      observer?.disconnect();
      observer = undefined;
      intersectionObserver?.disconnect();
      clear();
    },
    reconcile,
  };
}
