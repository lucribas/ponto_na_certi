import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    port: 4174,
    reuseExistingServer: true,
  },
  use: {
    trace: 'retain-on-failure',
  },
});
