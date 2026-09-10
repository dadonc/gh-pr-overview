import { createRoot, type Root } from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';

import { startContentRuntime } from '../lib/content-runtime';
import {
  enabledFromStorageChange,
  readEnabled,
} from '../lib/extension-toggle';
import { PULL_REQUEST_ROW_SELECTOR } from '../lib/github-row-dom';
import { createGitHubClient } from '../lib/github-client';
import { CARD_STYLES, PullRequestCard } from '../lib/pr-card';

export default defineContentScript({
  allFrames: false,
  matches: ['https://github.com/*'],
  runAt: 'document_idle',
  world: 'ISOLATED',
  async main(ctx) {
    let invalidated = false;
    let runtime: ReturnType<typeof startContentRuntime> | undefined;
    let latestObservedEnabled: boolean | undefined;
    const onStorageChanged = (
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ) => {
      const enabled = enabledFromStorageChange(changes, areaName);
      if (enabled === undefined) return;
      latestObservedEnabled = enabled;
      runtime?.setEnabled(enabled);
    };
    browser.storage.onChanged.addListener(onStorageChanged);
    ctx.onInvalidated(() => {
      invalidated = true;
      browser.storage.onChanged.removeListener(onStorageChanged);
    });

    const initiallyEnabled = await readEnabled(browser.storage.local);
    if (invalidated) return;
    const client = createGitHubClient();
    runtime = startContentRuntime({
      ctx,
      client,
      initiallyEnabled: latestObservedEnabled ?? initiallyEnabled,
      uiFactory: {
        async mount(anchor, props) {
          const ui = await createShadowRootUi<Root>(ctx, {
            anchor,
            append: 'after',
            css: CARD_STYLES,
            isolateEvents: ['keydown', 'keyup'],
            name: 'github-pr-overview',
            onMount(container) {
              const root = createRoot(container);
              root.render(<PullRequestCard {...props} />);
              return root;
            },
            onRemove(root) { root?.unmount(); },
            position: 'inline',
          });
          ui.mount();
          return {
            isConnected() {
              return ui.shadowHost.isConnected &&
                ui.shadowHost.closest(PULL_REQUEST_ROW_SELECTOR) ===
                  anchor.closest(PULL_REQUEST_ROW_SELECTOR);
            },
            remove() { ui.remove(); },
            update(next) { ui.mounted?.render(<PullRequestCard {...next} />); },
          };
        },
      },
    });
  },
});
