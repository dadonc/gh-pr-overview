import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    description: "Adds compact review-thread, diff, and AI-agent summaries alongside GitHub's native pull request comment counts.",
    name: 'GitHub PR Overview',
  },
  modules: ['@wxt-dev/module-react'],
  outDir: 'output',
});
