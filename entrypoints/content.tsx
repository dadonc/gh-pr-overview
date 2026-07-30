import { createRoot, type Root } from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';

import { startContentRuntime } from '../lib/content-runtime';
import { createGitHubClient } from '../lib/github-client';
import { CARD_STYLES, PullRequestCard } from '../lib/pr-card';

export default defineContentScript({
  allFrames: false,
  matches: ['https://github.com/*/*/pulls*'],
  runAt: 'document_idle',
  world: 'ISOLATED',
  async main(ctx) {
    const client = createGitHubClient();
    startContentRuntime({
      ctx,
      client,
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
                ui.shadowHost.closest('[id^="issue_"].js-issue-row') ===
                  anchor.closest('[id^="issue_"].js-issue-row');
            },
            remove() { ui.remove(); },
            update(next) { ui.mounted?.render(<PullRequestCard {...next} />); },
          };
        },
      },
    });
  },
});
