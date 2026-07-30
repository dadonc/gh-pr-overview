import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    description: 'Adds compact comment, review-thread, diff, and AI-agent summaries to GitHub pull request lists.',
    name: 'GitHub PR Overview',
  },
  modules: ['@wxt-dev/module-react'],
  outDir: 'output',
});
