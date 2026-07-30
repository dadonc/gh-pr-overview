import { defineConfig } from '@playwright/test';

export default defineConfig({
  fullyParallel: false,
  retries: 0,
  testDir: 'test/e2e',
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  workers: 1,
});
