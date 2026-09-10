import type { PullRequestClient, CardUiFactory, ObserverConstructor } from './pr-reconciler';
import { createPageReconciler, isPullRequestListRoute } from './pr-reconciler';

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

export interface ContentRuntimeController {
  setEnabled(enabled: boolean): void;
}

export interface ContentRuntimeOptions {
  ctx: ContentScriptLifecycle;
  client: PullRequestClient;
  document?: Document;
  initiallyEnabled?: boolean;
  IntersectionObserver?: ObserverConstructor;
  uiFactory: CardUiFactory;
}

/** Binds the testable page reconciler to WXT's Turbo-navigation lifecycle. */
export function startContentRuntime(options: ContentRuntimeOptions): ContentRuntimeController {
  const document = options.document ?? globalThis.document;
  let reconciler: ReturnType<typeof createPageReconciler> | undefined;
  let invalidated = false;
  let enabled = options.initiallyEnabled ?? true;

  const reconcileRoute = () => {
    if (invalidated) return;
    if (!enabled || !isPullRequestListRoute(document.location)) {
      reconciler?.cleanup();
      reconciler = undefined;
      return;
    }
    reconciler ??= createPageReconciler({
      document,
      client: options.client,
      IntersectionObserver: options.IntersectionObserver ?? globalThis.IntersectionObserver as ObserverConstructor | undefined,
      uiFactory: options.uiFactory,
    });
    reconciler.reconcile();
  };

  const setEnabled = (next: boolean) => {
    if (invalidated || next === enabled) return;
    enabled = next;
    reconcileRoute();
  };
  reconcileRoute();
  let pendingUrl: URL | undefined;
  let framePending = false;
  const scheduleCommittedReconcile = (newUrl: URL) => {
    pendingUrl = newUrl;
    if (framePending) return;
    framePending = true;
    options.ctx.requestAnimationFrame(() => {
      framePending = false;
      const expected = pendingUrl;
      if (!invalidated && expected && document.location.href === expected.href) reconcileRoute();
    });
  };
  options.ctx.addEventListener(window, 'wxt:locationchange', (event) => {
    if (enabled) scheduleCommittedReconcile(event.newUrl);
  });
  options.ctx.onInvalidated(() => {
    invalidated = true;
    reconciler?.cleanup();
    reconciler = undefined;
  });
  return { setEnabled };
}
