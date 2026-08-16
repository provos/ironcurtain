import { defineConfig, devices } from '@playwright/test';

const webUiPort = parseInt(process.env.IRONCURTAIN_WEB_UI_PORT ?? '5173', 10);
const mockPort = parseInt(process.env.IRONCURTAIN_MOCK_PORT ?? '7400', 10);
const resetPort = parseInt(process.env.IRONCURTAIN_MOCK_RESET_PORT ?? '7401', 10);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  outputDir: 'e2e-results',
  use: {
    baseURL: `http://localhost:${webUiPort}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `PORT=${mockPort} RESET_PORT=${resetPort} npx tsx scripts/mock-ws-server.ts`,
      url: `http://127.0.0.1:${resetPort}/__ready`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `IRONCURTAIN_WEB_UI_PORT=${webUiPort} IRONCURTAIN_WEB_UI_DAEMON_PORT=${mockPort} npx vite dev`,
      port: webUiPort,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
