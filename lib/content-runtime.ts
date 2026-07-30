import type { PullRequestClient, CardUiFactory, ObserverConstructor } from './pr-reconciler';
import { createPageReconciler } from './pr-reconciler';

export interface WxtLocationChangeEvent extends Event {
  readonly newUrl: URL;
}

export interface ContentScriptLifecycle {
  addEventListener(
    target: Window,
    type: 'wxt:locationchange',
    listener: (event: WxtLocationChangeEvent) => void,
  ): void;
  onInvalidated(listener: () => void): () => void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

export interface ContentRuntimeOptions {
  ctx: ContentScriptLifecycle;
  client: PullRequestClient;
  document?: Document;
  IntersectionObserver?: ObserverConstructor;
  uiFactory: CardUiFactory;
}

/** Binds the testable page reconciler to WXT's Turbo-navigation lifecycle. */
export function startContentRuntime(options: ContentRuntimeOptions) {
  const document = options.document ?? globalThis.document;
  const reconciler = createPageReconciler({
    document,
    client: options.client,
    IntersectionObserver: options.IntersectionObserver ?? globalThis.IntersectionObserver as ObserverConstructor | undefined,
    uiFactory: options.uiFactory,
  });
  reconciler.reconcile();
  let pendingUrl: URL | undefined;
  let framePending = false;
  let invalidated = false;
  const scheduleCommittedReconcile = (newUrl: URL) => {
    pendingUrl = newUrl;
    if (framePending) return;
    framePending = true;
    options.ctx.requestAnimationFrame(() => {
      framePending = false;
      const expected = pendingUrl;
      if (!invalidated && expected && document.location.href === expected.href) reconciler.reconcile();
    });
  };
  options.ctx.addEventListener(window, 'wxt:locationchange', (event) => scheduleCommittedReconcile(event.newUrl));
  options.ctx.onInvalidated(() => { invalidated = true; reconciler.cleanup(); });
  return reconciler;
}
