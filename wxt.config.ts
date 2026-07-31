import { defineConfig } from 'wxt';

import { ACTIVE_ICON_PATHS } from './lib/extension-toggle';

export default defineConfig({
  manifest: {
    action: { default_icon: ACTIVE_ICON_PATHS },
    description: "Adds compact review-thread, diff, and AI-agent summaries alongside GitHub's native pull request comment counts.",
    name: 'GitHub PR Overview',
    permissions: ['storage'],
  },
  modules: ['@wxt-dev/module-react'],
  outDir: 'output',
});
