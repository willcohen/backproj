import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 300_000,
  use: {
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'node tests/server.mjs',
    port: 8973,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
