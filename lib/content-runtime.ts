import type { PullRequestClient, CardUiFactory, ObserverConstructor } from './pr-reconciler';
import { createPageReconciler } from './pr-reconciler';

export interface ContentScriptLifecycle {
  addEventListener(target: Window, type: 'wxt:locationchange', listener: EventListener): void;
  onInvalidated(listener: () => void): () => void;
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
  options.ctx.addEventListener(window, 'wxt:locationchange', () => reconciler.reset());
  options.ctx.onInvalidated(() => reconciler.cleanup());
  return reconciler;
}
