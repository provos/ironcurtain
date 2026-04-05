import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  outputDir: 'e2e-results',
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx scripts/mock-ws-server.ts',
      port: 7400,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite dev',
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
